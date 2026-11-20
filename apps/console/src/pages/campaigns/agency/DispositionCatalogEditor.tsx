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
import {
  AGENCY_OVERRIDE_EXTRA_ATTEMPTS_MAX,
  AGENCY_PROMISE_FOLLOW_UP_DAYS_MAX,
  AGENCY_PROMISE_FOLLOW_UP_DAYS_MIN,
} from '@magick-agency/contracts/agency';
import type { ConfigFieldErrors } from './configFieldErrors';
import { TileIconPicker } from '../../../components/agency/TileIconPicker';
import styles from './CampaignBehaviourSection.module.css';

/*
  One of the four editors `CampaignBehaviourSection` assembles. Every rule lives
  in `utils/agencyCampaignConfigForm.ts`; this is the markup and the copy that is
  itself the feature. `errors` is the section's, so every field's error id and
  `aria-describedby` come from one place.
*/

interface DispositionCatalogEditorProps {
  dispositions: AgencyDispositionEntry[];
  /**
   * The entries after an edit, and the edit itself — what a caller following a row
   * through it needs (the campaign forms' automatic-outcome mapping,
   * `followCatalogEdit`).
   */
  onChange: (next: AgencyDispositionEntry[], edit: CatalogEdit) => void;
  errors: ConfigFieldErrors;
  /**
   * Offer each outcome's "Allows override" group (contact assignment). Off by
   * default: the soft phone's settings reuse this editor, and an override is a
   * campaign feature the server refuses in that catalog. The campaign forms turn
   * it on while the `agency_contact_assignment_enabled` flag is on.
   */
  overrides?: boolean;
  /**
   * Offer each outcome's "Promise to pay" group (PT1, PT2). Off by default: the soft phone's
   * and inbound routes' own catalogues reuse this editor, and the server refuses a promise
   * there (their calls have no campaign contact to keep it on). The campaign forms turn it on.
   */
  promises?: boolean;
  /**
   * Offer each outcome's tile picture (agent station BE-13): `icon`, one of the pictures the
   * station draws, or none. Off by default: only a campaign's catalogue carries one (the server
   * checks it there); the campaign forms turn it on.
   */
  icons?: boolean;
}

/** Copy of the promise group: what the agent is asked, and what it does (PT3). */
export const PROMISE_FLAG_TITLE = 'Asks for a promise to pay';
export const PROMISE_FLAG_BLURB =
  'The agent enters the date the customer promised to pay, and the amount if they gave one. Recording a promise does not book a call by itself.';
export const PROMISE_FOLLOW_UP_LABEL = 'Call again after the promised date';

/**
 * The outcome catalog: one card per outcome, in the agent's number-key order.
 *
 * The edit logic is `editCatalog`, a pure reducer — which rows still take their
 * code from their label, kept in step through adds, removals and moves, is its
 * state and is tested there. This component holds that set across renders
 * (rows this session added; a loaded row never follows its label) and writes the
 * entries back through `onChange`.
 */
export function DispositionCatalogEditor({
  dispositions,
  onChange,
  errors,
  overrides = false,
  promises = false,
  icons = false,
}: DispositionCatalogEditorProps) {
  const autoCodeRows = useRef<ReadonlySet<number>>(new Set());

  const edit = (action: CatalogEdit) => {
    const next = editCatalog({ dispositions, autoCodeRows: autoCodeRows.current }, action);
    autoCodeRows.current = next.autoCodeRows;
    if (next.dispositions !== dispositions) onChange(next.dispositions, action);
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
          // A wrong retry value keeps its inputs on screen even where the rule is inert:
          // Save is held by it either way, and it has to have something to change.
          const retryWrong = errors.message(`disposition_catalog[${index}].retry.max_attempts`) !== null
            || errors.message(`disposition_catalog[${index}].retry.delay_minutes`) !== null;
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
                {icons ? (
                  <TileIconPicker
                    value={entry.icon}
                    name={name}
                    onChange={(icon) => edit({ type: 'update', index, patch: { icon } })}
                    describedBy={errors.describedBy(`disposition_catalog[${index}].icon`)}
                    testId={`outcome-icon-${index}`}
                  />
                ) : null}
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
              {retryUnreachable && !retryWrong ? (
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
                ── Promise to pay (PT1, PT2) ───────────────────────────────
                The agent records the date the customer promised to pay. A
                follow-up is optional, and offered only where the server would
                accept it: not on an outcome that stops calling or ends the
                contact, and not beside its own retry.
              */}
              {promises ? (
                <div
                  className={styles.dispositionRetry}
                  role="group"
                  aria-label={`${name}: promise to pay`}
                  data-testid={`promise-group-${index}`}
                >
                  <label className={styles.flag} data-on={entry.requires_promise ? '' : undefined}>
                    <input
                      type="checkbox"
                      checked={Boolean(entry.requires_promise)}
                      aria-describedby={errors.describedBy(`disposition_catalog[${index}].requires_promise`)}
                      onChange={(event) => edit({ type: 'update', index, patch: { requires_promise: event.target.checked } })}
                    />
                    <span className={styles.flagText}>
                      <span className={styles.flagTitle}>{PROMISE_FLAG_TITLE}</span>
                      <span className={styles.flagBlurb}>{PROMISE_FLAG_BLURB}</span>
                    </span>
                  </label>
                  {/*
                    Shown whenever a follow-up is set, too, so one the operator made
                    impossible (by ticking "Ends this contact", say) can be turned off
                    where its error is shown.
                  */}
                  {(entry.requires_promise && !retryUnreachable && !entry.retry) || entry.promise_follow_up_days !== undefined ? (
                    <>
                      <label className={styles.retryToggle}>
                        <input
                          type="checkbox"
                          checked={entry.promise_follow_up_days !== undefined}
                          onChange={(event) => edit({
                            type: 'update',
                            index,
                            patch: { promise_follow_up_days: event.target.checked ? AGENCY_PROMISE_FOLLOW_UP_DAYS_MIN : undefined },
                          })}
                        />
                        {PROMISE_FOLLOW_UP_LABEL}
                      </label>
                      {entry.promise_follow_up_days !== undefined ? (
                        <div className={styles.retryFields}>
                          <label className={styles.retryField}>
                            <input
                              type="number"
                              min={AGENCY_PROMISE_FOLLOW_UP_DAYS_MIN}
                              max={AGENCY_PROMISE_FOLLOW_UP_DAYS_MAX}
                              aria-label={`${name} follow-up days after the promised date`}
                              aria-describedby={errors.describedBy(`disposition_catalog[${index}].promise_follow_up_days`)}
                              value={entry.promise_follow_up_days}
                              onChange={(event) => edit({
                                type: 'update',
                                index,
                                // 0 or empty would read as "off"; keep it on and let validation say the bound.
                                patch: { promise_follow_up_days: Number(event.target.value) || AGENCY_PROMISE_FOLLOW_UP_DAYS_MIN },
                              })}
                            />
                            days after the promised date, in calling hours
                          </label>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ) : null}

              {/*
                ── Allows override ─────────────────────────────────────────
                What filing this outcome lets the contact's agent do next, for
                this contact only. Hidden where the outcome suppresses or ends
                the contact: nothing would read it, and the server refuses it
                there. There is deliberately no Do Not Call part — DNC is never
                overridable, so it is not offered.
              */}
              {overrides && !retryUnreachable ? (
                <div
                  className={styles.dispositionRetry}
                  role="group"
                  aria-label={`What ${name} allows the agent`}
                  data-testid={`override-group-${index}`}
                >
                  <p className={styles.flagTitle}>Allows override</p>
                  <label className={styles.retryToggle}>
                    <input
                      type="checkbox"
                      checked={Boolean(entry.override?.extra_attempts)}
                      onChange={(event) => edit({
                        type: 'setOverride',
                        index,
                        patch: { extra_attempts: event.target.checked ? 1 : undefined },
                      })}
                    />
                    Extra attempts past the limit
                  </label>
                  {entry.override?.extra_attempts ? (
                    <div className={styles.retryFields}>
                      <label className={styles.retryField}>
                        up to
                        <input
                          type="number"
                          min={1}
                          max={AGENCY_OVERRIDE_EXTRA_ATTEMPTS_MAX}
                          aria-label={`${name} extra attempts`}
                          aria-describedby={errors.describedBy(`disposition_catalog[${index}].override.extra_attempts`)}
                          value={entry.override.extra_attempts}
                          onChange={(event) => edit({
                            type: 'setOverride',
                            index,
                            // 0 would clear the part; keep the box ticked and let
                            // validation say the bound instead.
                            patch: { extra_attempts: Number(event.target.value) || 1 },
                          })}
                        />
                        more
                      </label>
                    </div>
                  ) : null}
                  <label className={styles.retryToggle}>
                    <input
                      type="checkbox"
                      checked={Boolean(entry.override?.retry_delay)}
                      onChange={(event) => edit({
                        type: 'setOverride',
                        index,
                        patch: { retry_delay: event.target.checked },
                      })}
                    />
                    May dial before the next scheduled time
                  </label>
                  <label className={styles.retryToggle}>
                    <input
                      type="checkbox"
                      checked={Boolean(entry.override?.calling_hours)}
                      onChange={(event) => edit({
                        type: 'setOverride',
                        index,
                        patch: { calling_hours: event.target.checked },
                      })}
                    />
                    May dial outside calling hours (needs a note)
                  </label>
                </div>
              ) : null}

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
              {icons ? errors.render(`disposition_catalog[${index}].icon`) : null}
              {errors.render(`disposition_catalog[${index}].retry.max_attempts`)}
              {errors.render(`disposition_catalog[${index}].retry.delay_minutes`)}
              {errors.render(`disposition_catalog[${index}].override`)}
              {errors.render(`disposition_catalog[${index}].override.extra_attempts`)}
              {errors.render(`disposition_catalog[${index}].requires_promise`)}
              {errors.render(`disposition_catalog[${index}].promise_follow_up_days`)}
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
