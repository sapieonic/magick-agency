import { useCallback, useRef } from 'react';
import { ArrowDown, ArrowUp, Lock, Plus, Trash2 } from 'lucide-react';
import { ComposerSection } from '../components/ComposerSection';
import {
  BUILT_IN_LOCK_COPY,
  DEFAULT_DISPOSITION_RETRY,
  DISPOSITION_FLAGS,
  FIXED_ZERO_COPY,
  FIXED_ZERO_OUTCOMES,
  OUR_FAULT_RETRY_COPY,
  OUR_FAULT_RETRY_DEFAULT,
  OUR_FAULT_RETRY_OUTCOMES,
  OUR_FAULT_ZERO_WARNING,
  OUTCOME_LABELS,
  RETRY_OUTCOMES,
  SUPPRESS_BEATS_TERMINAL_NOTE,
  VOICEMAIL_RETRY_COPY,
  callingWindowEcho,
  dispositionSummary,
  isBuiltInCode,
  retryPreview,
  slugifyCode,
  type CampaignConfigState,
} from '../../../utils/agencyCampaignConfigForm';
import type { AgencyDispositionEntry, AgencyRetryOutcome } from '../../../types/agency-campaign';
import styles from './CampaignBehaviourSection.module.css';

/**
 * Campaign configuration: calling hours, the
 * disposition catalog, the retry policy and wrap-up.
 *
 * Every rule lives in `utils/agencyCampaignConfigForm.ts`; this is assembly plus
 * the pieces of copy that are themselves the feature:
 *
 *  - **The built-in lock explains itself inline.** A lock icon with no reason
 *    reads as a permissions bug, and the reason is not "the server refuses" —
 *    the server deliberately does not enforce it. It is that removing one silently
 *    removes a capability the agent needs.
 *  - **`invalid` and `connected` are shown fixed at zero**, not hidden. Hiding
 *    them invites the operator to assume they retry.
 *  - **`agent_disconnected` and `canceled` are labelled "our fault"** (`canceled` came from the 2026-09-08 pilot) and share one callout
 *    saying the thing about them that
 *    is easy to get wrong: the row can only LOWER the API's platform bound, never
 *    raise it, and lowering it to 0 retires the contact on the first pre-connect
 *    failure rather than merely skipping a redial. `orphaned` is deliberately
 *    absent — the API never reads a campaign's value for it, so the row would be an
 *    inert control, which is the test `canceled` passes and it does not.
 *  - **Concurrency is displayed, never offered.** No input, no
 *    stepper, no Edit link — a greyed-out input reads as "you lack permission
 *    today" and produces a support ticket with no resolution.
 *
 * ── The outcome card ─────────────────────────────────────────────────────────
 * An outcome used to be a code box, a label box, and five bare checkboxes in a
 * wrapping row. Four things were wrong with it and each is answered here:
 *
 *  - **The flags described mechanisms, not behaviour.** "Ends this contact" and
 *    "Stops calling this contact" sat side by side as if they were the same
 *    setting worded twice. Each is now a tile carrying the sentence that says
 *    what it does, and the card closes with {@link dispositionSummary} — the
 *    combination stated as one sentence, the same argument as the calling-window
 *    echo. `suppress` + `terminal` together get {@link SUPPRESS_BEATS_TERMINAL_NOTE},
 *    because the API returns on the first and the second is then unreachable.
 *  - **The order was declared to matter and could not be changed.** The hint
 *    said this is the agent's number-key order; the only way to reorder was to
 *    delete an entry and retype it, and a built-in could not be deleted at all.
 *    The keycap now shows the key an agent presses and the arrows move it.
 *  - **The code was a jargon field asked twice.** It follows the label while it
 *    has not been edited by hand ({@link slugifyCode}), and on a built-in it is
 *    a locked chip rather than a `readOnly` input — a text box that refuses
 *    typing reads as a bug, not as a rule.
 *  - **A disposition's own retry had no control.** The retry table below says in
 *    so many words that voicemail retry "lives on the voicemail disposition, not
 *    in this table", and the default voicemail entry does carry a 4-hour, 2-try
 *    rule — which nothing on the screen showed and nothing could change, while
 *    `validateConfig` was already rendering errors for the field. It is offered
 *    here, and hidden behind the precedence note when `suppress` or `terminal`
 *    makes it unreachable rather than being shown as a control that does nothing.
 */

const DAYS: { iso: number; label: string }[] = [
  { iso: 1, label: 'Mon' },
  { iso: 2, label: 'Tue' },
  { iso: 3, label: 'Wed' },
  { iso: 4, label: 'Thu' },
  { iso: 5, label: 'Fri' },
  { iso: 6, label: 'Sat' },
  { iso: 7, label: 'Sun' },
];

export type BehaviourSectionId = 'hours' | 'behaviour';

export interface CampaignBehaviourSectionProps {
  state: CampaignConfigState;
  onChange: (next: CampaignConfigState) => void;
  /** Keyed by body path — client findings and the server's `details` land alike. */
  fieldErrors: Record<string, string>;
  /** Injectable for tests; the echo is clock-derived. */
  now?: Date;
  /**
   * `sections` is the settings-page layout (titled cards). `plain` is the
   * builder step body — the page already supplies the title.
   */
  layout?: 'sections' | 'plain';
  /** Which editors to render. Defaults to both, so the settings page is unchanged. */
  include?: readonly BehaviourSectionId[];
}

const COMMON_TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Australia/Sydney',
  'UTC',
];

export function CampaignBehaviourSection({
  state,
  onChange,
  fieldErrors,
  now,
  layout = 'sections',
  include = ['hours', 'behaviour'],
}: CampaignBehaviourSectionProps) {
  const error = (field: string) => fieldErrors[field] ?? null;

  const setWindow = (patch: Partial<CampaignConfigState['window']>) =>
    onChange({ ...state, window: { ...state.window, ...patch } });

  const toggleDay = (iso: number) => {
    const days = state.window.days.includes(iso)
      ? state.window.days.filter((day) => day !== iso)
      : [...state.window.days, iso].sort((a, b) => a - b);
    setWindow({ days });
  };

  const setRetry = (outcome: AgencyRetryOutcome, patch: { delay?: number; max?: number }) => {
    /*
      The seed supplies whichever half the operator did NOT type, so it has to be
      a value that is safe to have been chosen for them.

      For an our-fault row, `max_attempts: 0` is not: the API reads
      `min(configured, OUR_FAULT_REDIAL_BOUND)` and retires the contact once
      `ourFaultAttemptsUsed >= effectiveBound`, so a zero it never saw typed
      meant one agent-side drop before connect permanently retired that contact.
      Typing a number into the *delay* box was enough to do it. Seeding from
      the API's own default keeps an untouched field at the API's behaviour, which is
      what an operator editing the other field is entitled to assume.
    */
    const seed = OUR_FAULT_RETRY_OUTCOMES.includes(outcome)
      ? OUR_FAULT_RETRY_DEFAULT
      : { max_attempts: 0 };
    const existing = state.retryPolicy[outcome] ?? seed;
    const next = {
      ...existing,
      ...(patch.max !== undefined ? { max_attempts: patch.max } : {}),
      ...(patch.delay !== undefined ? { delay_minutes: patch.delay } : {}),
    };
    onChange({ ...state, retryPolicy: { ...state.retryPolicy, [outcome]: next } });
  };

  const updateDisposition = (index: number, patch: Partial<AgencyDispositionEntry>) => {
    const dispositions = state.dispositions.map((entry, i) =>
      i === index ? { ...entry, ...patch } : entry,
    );
    onChange({ ...state, dispositions });
  };

  /**
   * Which rows may take their code from their label — rows this session ADDED,
   * and only until their code is typed into.
   *
   * The obvious stateless test, "the code still equals the label's own slug",
   * is wrong on a campaign that already exists. A careful operator who typed
   * `promised_to_pay` beside "Promised to pay" months ago produces an entry
   * that passes that test on the very first render, so fixing a typo in the
   * label would silently rewrite a code that every historical call record is
   * filed under. Nothing on screen would say so, and the save would look
   * ordinary. A loaded row is therefore never in this set: a code that has been
   * saved once is the operator's, not ours.
   *
   * Indices, kept in step with the list by the three mutators below — the same
   * identity the list itself uses for its keys.
   */
  const autoCodeRows = useRef<Set<number>>(new Set());

  const renameDisposition = (index: number, label: string) => {
    const entry = state.dispositions[index];
    if (!entry) return;
    const derive = autoCodeRows.current.has(index) && !isBuiltInCode(entry.code);
    updateDisposition(index, { label, ...(derive ? { code: slugifyCode(label) } : {}) });
  };

  /** A hand-typed code detaches the row from its label for good. */
  const setDispositionCode = (index: number, code: string) => {
    autoCodeRows.current.delete(index);
    updateDisposition(index, { code });
  };

  const removeDisposition = (index: number) => {
    const entry = state.dispositions[index];
    if (!entry || isBuiltInCode(entry.code)) return;
    const shifted = new Set<number>();
    for (const row of autoCodeRows.current) {
      if (row < index) shifted.add(row);
      else if (row > index) shifted.add(row - 1);
    }
    autoCodeRows.current = shifted;
    onChange({ ...state, dispositions: state.dispositions.filter((_, i) => i !== index) });
  };

  /**
   * Swap two entries. Built-ins move like any other: the lock is against
   * *deletion* (removing one removes a capability agents need), and it was never
   * against position — the order is the agent's number-key order and nothing
   * downstream reads it.
   */
  const moveDisposition = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    const dispositions = [...state.dispositions];
    const from = dispositions[index];
    const to = dispositions[target];
    if (!from || !to) return;
    dispositions[index] = to;
    dispositions[target] = from;
    const rows = autoCodeRows.current;
    const fromAuto = rows.has(index);
    const toAuto = rows.has(target);
    rows.delete(index);
    rows.delete(target);
    if (toAuto) rows.add(index);
    if (fromAuto) rows.add(target);
    onChange({ ...state, dispositions });
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
    focusRow.current = state.dispositions.length;
    autoCodeRows.current.add(state.dispositions.length);
    onChange({
      ...state,
      dispositions: [...state.dispositions, { code: '', label: '' }],
    });
  };

  /**
   * A disposition's own retry rule. Seeded from the voicemail default rather
   * than from zero, for the same reason the policy rows are: `max_attempts: 0`
   * is a rule that never fires, so seeding it means switching the control on
   * appears to do nothing.
   */
  const toggleDispositionRetry = (index: number, on: boolean) =>
    updateDisposition(index, { retry: on ? { ...DEFAULT_DISPOSITION_RETRY } : undefined });

  const showHours = include.includes('hours');
  const showBehaviour = include.includes('behaviour');

  const hours = (
    <>
        <div className={styles.row}>
          <div className="form-group">
            <label htmlFor="window-start">Start</label>
            <input
              id="window-start"
              type="time"
              value={state.window.start}
              onChange={(event) => setWindow({ start: event.target.value })}
            />
            <FieldError message={error('calling_window_start')} />
          </div>
          <div className="form-group">
            <label htmlFor="window-end">End</label>
            <input
              id="window-end"
              type="time"
              value={state.window.end}
              onChange={(event) => setWindow({ end: event.target.value })}
            />
            <FieldError message={error('calling_window_end')} />
          </div>
          <div className="form-group">
            <label htmlFor="window-timezone">Default timezone</label>
            <input
              id="window-timezone"
              value={state.window.timezone}
              placeholder="Asia/Kolkata"
              list="campaign-timezone-options"
              onChange={(event) => setWindow({ timezone: event.target.value })}
            />
            <datalist id="campaign-timezone-options">
              {COMMON_TIMEZONES.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
            <FieldError message={error('default_timezone')} />
          </div>
        </div>

        <fieldset className={styles.days}>
          <legend className={styles.legend}>Calling days</legend>
          {DAYS.map((day) => (
            <label key={day.iso} className={styles.day}>
              <input
                type="checkbox"
                checked={state.window.days.includes(day.iso)}
                onChange={() => toggleDay(day.iso)}
              />
              {day.label}
            </label>
          ))}
          <FieldError message={error('calling_days')} />
        </fieldset>

        {/* The echo — an inverted range is invisible in a pair of time inputs. */}
        <p className={styles.echo} data-testid="calling-window-echo">
          {callingWindowEcho(state.window, now)}
        </p>

        {/*
          Concurrency is displayed, never offered. There is no `/proxy/account-settings`
          route and none is being added — concurrency is a commercial lever, and an
          account that can raise its own limit can raise its own carrier spend.
          Broadcasts (not agency campaigns) now have a narrow READ-ONLY projection,
          `GET /proxy/calls/concurrency-limits`, and a per-broadcast "Simultaneous
          calls" cap that can only LOWER concurrency below that limit — never raise
          it. Nothing here changes: the agency pacing engine
          has no per-campaign cap, and this stays a read-out.
        */}
        <p className={styles.concurrency} data-testid="concurrency-note">
          Simultaneous calls are capped by your account&apos;s limit, which is shared with your AI
          calls. Contact support to change it.
        </p>
    </>
  );

  const behaviour = (
    <>
        <h3 className={styles.subhead}>Outcomes</h3>
        <p className={styles.sectionLead}>
          What an agent can file at the end of a call, and what each one does to the contact. The
          order is the number key they press, so it is worth getting right.
        </p>
        <ul className={styles.dispositions}>
          {state.dispositions.map((entry, index) => {
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
                this list actually has: `moveDisposition` swaps by index and
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
                      onChange={(event) => renameDisposition(index, event.target.value)}
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
                        onChange={(event) => setDispositionCode(index, event.target.value)}
                      />
                    )}
                  </div>
                  <div className={styles.dispositionActions}>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => moveDisposition(index, -1)}
                      disabled={index === 0}
                      aria-label={`Move ${name} up`}
                      title="Move up — this is the agent's number key"
                    >
                      <ArrowUp size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => moveDisposition(index, 1)}
                      disabled={index === state.dispositions.length - 1}
                      aria-label={`Move ${name} down`}
                      title="Move down — this is the agent's number key"
                    >
                      <ArrowDown size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={`${styles.iconBtn} ${styles.removeBtn}`}
                      onClick={() => removeDisposition(index)}
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
                          updateDisposition(index, { [flag]: event.target.checked })
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
                        onChange={(event) => toggleDispositionRetry(index, event.target.checked)}
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
                            value={entry.retry.delay_minutes ?? 0}
                            onChange={(event) =>
                              updateDisposition(index, {
                                retry: {
                                  ...entry.retry!,
                                  delay_minutes: Number(event.target.value),
                                },
                              })
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
                            value={entry.retry.max_attempts}
                            onChange={(event) =>
                              updateDisposition(index, {
                                retry: {
                                  ...entry.retry!,
                                  max_attempts: Number(event.target.value),
                                },
                              })
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

                <FieldError message={error(`disposition_catalog[${index}].code`)} />
                <FieldError message={error(`disposition_catalog[${index}].label`)} />
                <FieldError message={error(`disposition_catalog[${index}].retry.max_attempts`)} />
                <FieldError message={error(`disposition_catalog[${index}].retry.delay_minutes`)} />
              </li>
            );
          })}
        </ul>
        <button type="button" className={styles.addOutcome} onClick={addDisposition}>
          <Plus size={14} aria-hidden="true" /> Add an outcome
        </button>

        <h3 className={styles.subhead}>Retries</h3>
        <table className={styles.retryTable}>
          <thead>
            <tr>
              <th scope="col">Outcome</th>
              <th scope="col">Delay (minutes)</th>
              <th scope="col">Max attempts</th>
            </tr>
          </thead>
          <tbody>
            {RETRY_OUTCOMES.map((outcome) => {
              const fixed = FIXED_ZERO_OUTCOMES.includes(outcome);
              const ourFault = OUR_FAULT_RETRY_OUTCOMES.includes(outcome);
              const rule = state.retryPolicy[outcome];
              return (
                <tr key={outcome} data-our-fault={ourFault || undefined}>
                  <th scope="row">{OUTCOME_LABELS[outcome]}</th>
                  {fixed ? (
                    <td colSpan={2} className={styles.fixed} data-testid={`fixed-${outcome}`}>
                      Fixed at 0 — {FIXED_ZERO_COPY[outcome as keyof typeof FIXED_ZERO_COPY]}
                    </td>
                  ) : (
                    <>
                      <td>
                        <input
                          type="number"
                          min={0}
                          aria-label={`${OUTCOME_LABELS[outcome]} delay in minutes`}
                          value={rule?.delay_minutes ?? ''}
                          onChange={(event) =>
                            setRetry(outcome, { delay: Number(event.target.value) })
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min={0}
                          max={20}
                          aria-label={`${OUTCOME_LABELS[outcome]} max attempts`}
                          value={rule?.max_attempts ?? ''}
                          onChange={(event) => setRetry(outcome, { max: Number(event.target.value) })}
                        />
                        <FieldError message={error(`retry_policy.${outcome}.max_attempts`)} />
                        <FieldError message={error(`retry_policy.${outcome}.delay_minutes`)} />
                        {/*
                          Not a validation error — 0 is a legitimate choice. It
                          is a consequence the word "0" does not convey beside a
                          field labelled "attempts": the API retires the contact
                          outright rather than merely skipping a redial.
                        */}
                        {ourFault && rule?.max_attempts === 0 && (
                          <p className={styles.zeroWarning} data-testid={`our-fault-zero-${outcome}`}>
                            {OUR_FAULT_ZERO_WARNING}
                          </p>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>

        <ul className={styles.previews} data-testid="retry-previews">
          {RETRY_OUTCOMES.filter((outcome) => !FIXED_ZERO_OUTCOMES.includes(outcome)).map(
            (outcome) => (
              <li key={outcome}>{retryPreview(outcome, state.retryPolicy[outcome])}</li>
            ),
          )}
        </ul>

        <p className={styles.callout} data-testid="voicemail-retry-callout">
          {VOICEMAIL_RETRY_COPY}
        </p>

        {/*
          `agent_disconnected` and `canceled` (pilot
          2026-09-08): OUR
          fault, not the customer's. One callout for both rows — the rule it
          states is identical for each, and two paragraphs under one table would
          be read as one anyway.

          The earlier wording of this callout said the platform bound "cannot be
          raised from here" and called it "smaller". Both were misleading. The API
          takes `min(configured, OUR_FAULT_REDIAL_BOUND)`, so the row cannot
          raise it — true — but it CAN lower it, which is the half that bites;
          and the two are equal at 3, not smaller. An operator reading the old
          text would reasonably conclude this row could not affect the bound at
          all, and then set it to 0.
        */}
        <p className={styles.callout} data-testid="our-fault-retry-callout">
          {OUR_FAULT_RETRY_COPY}
        </p>

        <h3 className={styles.subhead}>Wrap-up</h3>
        <div className="form-group">
          <label htmlFor="wrapup-seconds">Wrap-up seconds (0 = none)</label>
          <input
            id="wrapup-seconds"
            type="number"
            min={0}
            max={600}
            value={state.wrapupSeconds}
            onChange={(event) => onChange({ ...state, wrapupSeconds: Number(event.target.value) })}
          />
          <FieldError message={error('wrapup_seconds')} />
          <p className={styles.hint}>
            {state.wrapupSeconds === 0
              ? 'Agents go straight back to available after a call.'
              : `Agents get ${state.wrapupSeconds}s to finish their write-up before the next call.`}
          </p>
        </div>

        {/*
          The other half of wrap-up, and the half that decides how an agent's
          shift feels: with it on, the countdown puts them back in the pool by
          itself; with it off, they sit in wrap-up until they say they are done.
          The API has long supported it and nothing here ever sent
          it, so every campaign ran on the column default.
        */}
        <div className="form-group">
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={state.autoReturn}
              onChange={(event) => onChange({ ...state, autoReturn: event.target.checked })}
            />
            Send agents back to the pool automatically when wrap-up ends
          </label>
          <p className={styles.hint} data-testid="auto-return-hint">
            {/*
              Named separately for `wrapupSeconds === 0` because the API only starts
              a countdown when there is BOTH a window and this flag
              (`wrapup-manager.ts`): with no window there is nothing to count
              down, so the checkbox is stored but inert until a window exists.
              Greying it out would lose that stored choice.
            */}
            {state.wrapupSeconds === 0
              ? 'With no wrap-up window there is no countdown, so this only takes effect once you set one above.'
              : state.autoReturn
                ? `After ${state.wrapupSeconds}s an agent becomes available again on their own — they can be handed a new call without touching anything.`
                : 'An agent stays in wrap-up until they mark themselves ready, however long that takes. Nothing hands them a new call in the meantime.'}
          </p>
        </div>
    </>
  );

  if (layout === 'plain') {
    return (
      <>
        {showHours ? hours : null}
        {showBehaviour ? behaviour : null}
      </>
    );
  }

  return (
    <>
      {showHours ? (
        <ComposerSection
          title="Calling hours"
          helper="When this campaign is allowed to dial."
        >
          {hours}
        </ComposerSection>
      ) : null}
      {showBehaviour ? (
        <ComposerSection
          title="Behaviour"
          helper="Outcomes agents can pick, how retries work, and wrap-up."
        >
          {behaviour}
        </ComposerSection>
      ) : null}
    </>
  );
}

function FieldError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="error-text" role="alert">
      {message}
    </p>
  );
}
