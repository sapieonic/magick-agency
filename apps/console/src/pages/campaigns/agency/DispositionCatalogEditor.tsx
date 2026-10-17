import { useCallback, useRef } from 'react';
import { ArrowDown, ArrowUp, Lock, Plus, Trash2 } from 'lucide-react';
import {
  BUILT_IN_LOCK_COPY,
  DISPOSITION_FLAGS,
  SUPPRESS_BEATS_TERMINAL_NOTE,
  dispositionSummary,
  editCatalog,
  isBuiltInCode,
  type CatalogEdit,
} from '../../../utils/agencyCampaignConfigForm';
import type { AgencyDispositionEntry } from '../../../types/agency-campaign';
import type { ConfigFieldErrors } from './configFieldErrors';
import styles from './CampaignBehaviourSection.module.css';

/*
  One of the four editors `CampaignBehaviourSection` assembles. Every rule lives
  in `utils/agencyCampaignConfigForm.ts`; this is the markup and the copy that is
  itself the feature. `errors` is the section's, so every field's error id and
  `aria-describedby` come from one place.
*/

interface DispositionCatalogEditorProps {
  dispositions: AgencyDispositionEntry[];
  onChange: (next: AgencyDispositionEntry[]) => void;
  errors: ConfigFieldErrors;
}

/**
 * The outcome catalog: one card per outcome, in the agent's number-key order.
 *
 * The edit logic is `editCatalog`, a pure reducer — which rows still take their
 * code from their label, kept in step through adds, removals and moves, is its
 * state and is tested there. This component holds that set across renders
 * (rows this session added; a loaded row never follows its label) and writes the
 * entries back through `onChange`.
 */
export function DispositionCatalogEditor({ dispositions, onChange, errors }: DispositionCatalogEditorProps) {
  const autoCodeRows = useRef<ReadonlySet<number>>(new Set());

  const edit = (action: CatalogEdit) => {
    const next = editCatalog({ dispositions, autoCodeRows: autoCodeRows.current }, action);
    autoCodeRows.current = next.autoCodeRows;
    if (next.dispositions !== dispositions) onChange(next.dispositions);
  };

  /*
    Focus the label of a row that was just added. Without it the operator has to
    go and find a card that appeared below the fold, and the first thing the
    empty card does is fail validation on the field they have not reached yet.
  */
  const focusRow = useRef<number | null>(null);
  const labelRef = useCallback((node: HTMLInputElement | null) => {
    if (node && focusRow.current !== null && Number(node.dataset.row) === focusRow.current) {
      focusRow.current = null;
      node.focus();
    }
  }, []);

  const addDisposition = () => {
    focusRow.current = dispositions.length;
    edit({ type: 'add' });
  };

  return (
    <>
      <h3 className={styles.subhead}>Outcomes</h3>
      <p className={styles.sectionLead}>
        What an agent can file at the end of a call, and what each one does to the contact. The
        order is the number key they press, so it is worth getting right.
      </p>
      <ul className={styles.dispositions}>
        {dispositions.map((entry, index) => {
          const locked = isBuiltInCode(entry.code);
          const name = entry.label || entry.code || `Outcome ${index + 1}`;
          /*
            Precedence, from the API's `resolveDispositionDecision`: suppress
            beats terminal beats callback beats disposition-retry. A retry
            control under either of the first two would be a control that
            cannot fire, so the reason takes its place.
          */
          const retryUnreachable = Boolean(entry.suppress || entry.terminal);
          return (
            /*
              Keyed by POSITION, never by code. The key used to embed
              `entry.code`, which is a value the operator types into — and,
              since a new outcome's code follows its label, a value that
              changed on every keystroke in the label field too. React saw
              the old key disappear, unmounted the card and mounted a fresh
              one, so the input being typed into was destroyed after each
              character and the caret went with it. Position is the identity
              this list actually has: `editCatalog`'s move swaps by index and
              every field is controlled, so there is no per-row state a
              positional key could mix up.
            */
            <li key={index} className={styles.disposition}>
              <div className={styles.dispositionRow}>
                {/*
                  Decorative, and marked so. The ordinal it draws is already
                  carried to a screen reader by the label field's own
                  `Outcome N label` and by the Move buttons; announcing a bare
                  unexplained "1" between them is noise, which is why the
                  number it replaced was `aria-hidden` too.
                */}
                <kbd
                  className={styles.key}
                  aria-hidden="true"
                  title={`Agents press ${index + 1} to file this outcome`}
                >
                  {index + 1}
                </kbd>
                <div className={styles.naming}>
                  <input
                    ref={labelRef}
                    data-row={index}
                    aria-label={`Outcome ${index + 1} label`}
                    className={styles.label}
                    value={entry.label}
                    placeholder="What the agent sees on the button"
                    onChange={(event) => edit({ type: 'rename', index, label: event.target.value })}
                    aria-describedby={errors.describedBy(
                      `disposition_catalog[${index}].label`,
                      // A built-in's code has no input of its own; its error is the label's.
                      ...(locked ? [`disposition_catalog[${index}].code`] : []),
                    )}
                  />
                  {/*
                    A built-in's code is a fixed wire value, so it is shown as
                    one. It used to be a `readOnly` text input, which looks
                    exactly like a field that is refusing to accept typing.
                  */}
                  {locked ? (
                    <span className={styles.codeChip} title="Built in — this code is fixed">
                      <Lock size={11} aria-hidden="true" />
                      {entry.code}
                    </span>
                  ) : (
                    <input
                      aria-label={`Outcome ${index + 1} code`}
                      className={styles.code}
                      value={entry.code}
                      placeholder="code"
                      title="The value stored against the call. Filled in from the label until you change it."
                      onChange={(event) => edit({ type: 'setCode', index, code: event.target.value })}
                      aria-describedby={errors.describedBy(`disposition_catalog[${index}].code`)}
                    />
                  )}
                </div>
                <div className={styles.dispositionActions}>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={() => edit({ type: 'move', index, delta: -1 })}
                    disabled={index === 0}
                    aria-label={`Move ${name} up`}
                    title="Move up — this is the agent's number key"
                  >
                    <ArrowUp size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={() => edit({ type: 'move', index, delta: 1 })}
                    disabled={index === dispositions.length - 1}
                    aria-label={`Move ${name} down`}
                    title="Move down — this is the agent's number key"
                  >
                    <ArrowDown size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={`${styles.iconBtn} ${styles.removeBtn}`}
                    onClick={() => edit({ type: 'remove', index })}
                    disabled={locked}
                    aria-label={`Remove ${name}`}
                    title={locked ? 'Built in — cannot be removed' : `Remove ${name}`}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>

              {locked ? (
                <p className={styles.lockCopy} data-testid={`lock-${entry.code}`}>
                  <Lock size={11} aria-hidden="true" />
                  <span>
                    Built in and kept:{' '}
                    {BUILT_IN_LOCK_COPY[entry.code as keyof typeof BUILT_IN_LOCK_COPY]}
                  </span>
                </p>
              ) : null}

              <div
                className={styles.flags}
                role="group"
                aria-label={`What happens when an agent files ${name}`}
              >
                {DISPOSITION_FLAGS.map(({ flag, title, blurb }) => (
                  <label
                    key={flag}
                    className={styles.flag}
                    data-on={entry[flag] ? '' : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(entry[flag])}
                      onChange={(event) =>
                        edit({ type: 'update', index, patch: { [flag]: event.target.checked } })
                      }
                    />
                    <span className={styles.flagText}>
                      <span className={styles.flagTitle}>{title}</span>
                      <span className={styles.flagBlurb}>{blurb}</span>
                    </span>
                  </label>
                ))}
              </div>

              {entry.suppress && entry.terminal ? (
                <p className={styles.precedence} data-testid={`precedence-${index}`}>
                  {SUPPRESS_BEATS_TERMINAL_NOTE}
                </p>
              ) : null}

              {/*
                The disposition's OWN retry — the one the retry table says
                lives here. Offered only where the API would read it.
              */}
              {retryUnreachable ? (
                entry.retry ? (
                  <p className={styles.precedence} data-testid={`retry-inert-${index}`}>
                    This outcome carries a retry rule, but nothing will act on it while the
                    contact is being ended or stopped.
                  </p>
                ) : null
              ) : (
                <div
                  className={styles.dispositionRetry}
                  role="group"
                  aria-label={`Calling ${name} back`}
                >
                  {/*
                    Grouped rather than given a unique `aria-label`: every card
                    carries this same sentence, and rewriting the accessible
                    name to include the outcome would no longer contain the
                    visible label (WCAG 2.5.3). The group name disambiguates
                    the cards instead.
                  */}
                  <label className={styles.retryToggle}>
                    <input
                      type="checkbox"
                      checked={Boolean(entry.retry)}
                      onChange={(event) => edit({ type: 'toggleRetry', index, on: event.target.checked })}
                    />
                    Call this contact again after this outcome
                  </label>
                  {entry.retry ? (
                    <div className={styles.retryFields}>
                      <label className={styles.retryField}>
                        after
                        <input
                          type="number"
                          min={0}
                          aria-label={`${name} retry delay in minutes`}
                          aria-describedby={errors.describedBy(`disposition_catalog[${index}].retry.delay_minutes`)}
                          value={entry.retry.delay_minutes ?? 0}
                          onChange={(event) =>
                            edit({ type: 'update', index, patch: {
                              retry: {
                                ...entry.retry!,
                                delay_minutes: Number(event.target.value),
                              },
                            } })
                          }
                        />
                        minutes,
                      </label>
                      <label className={styles.retryField}>
                        up to
                        <input
                          type="number"
                          min={0}
                          max={20}
                          aria-label={`${name} retry attempts`}
                          aria-describedby={errors.describedBy(`disposition_catalog[${index}].retry.max_attempts`)}
                          value={entry.retry.max_attempts}
                          onChange={(event) =>
                            edit({ type: 'update', index, patch: {
                              retry: {
                                ...entry.retry!,
                                max_attempts: Number(event.target.value),
                              },
                            } })
                          }
                        />
                        times
                      </label>
                    </div>
                  ) : null}
                </div>
              )}

              {/*
                The combination, in one sentence. Five checkboxes state five
                mechanisms; this is the only place the screen says what the
                operator has actually configured.
              */}
              <p className={styles.summary} data-testid={`outcome-summary-${index}`}>
                {dispositionSummary(entry)}
              </p>

              {errors.render(`disposition_catalog[${index}].code`)}
              {errors.render(`disposition_catalog[${index}].label`)}
              {errors.render(`disposition_catalog[${index}].retry.max_attempts`)}
              {errors.render(`disposition_catalog[${index}].retry.delay_minutes`)}
            </li>
          );
        })}
      </ul>
      <button type="button" className={styles.addOutcome} onClick={addDisposition}>
        <Plus size={14} aria-hidden="true" /> Add an outcome
      </button>
    </>
  );
}
