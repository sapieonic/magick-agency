import {
  useEffect,
  useImperativeHandle,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import { findDisposition, type DispositionFormState } from '../../utils/agencyDispositionForm';
import type { AgencyDisposition } from '../../types/agency';
import styles from './DispositionPad.module.css';

/**
 * The disposition pad.
 *
 * Pure assembly: every rule lives in `agencyDispositionForm` (validation),
 * `agencyDispositionSubmit` (outcome classification), `agencyStaleResponse` (the
 * cross-contact guard) and `agencyCatalogSync` (the `allowed_codes` rebuild). The
 * submit path itself is frozen at the API `606d3cb` and this component adds nothing
 * to it.
 *
 * ── The two things this component must not do ────────────────────────────────
 * **It never re-sorts the catalog.** `1`–`9` map to the first nine entries in the
 * order the API delivered them. A client-side sort — by label, by success flag,
 * anything — silently remaps every agent's muscle memory the moment an admin
 * renames a code, and it is invisible in review because both orders look
 * perfectly reasonable.
 *
 * **It never clears the notes.** Not on a rejection, not on a conflict, not on a
 * re-sync. The note is the agent's only artefact of an eight-minute call, and no
 * error path is allowed to spend it.
 *
 * ── Where the submit button is, and why not here ─────────────────────────────
 * In the action bar, with the block reason beside it. The pad is the
 * *selection* surface; putting the submit inside it would put "Save disposition"
 * in a scrolling region, and a control that can scroll out of reach during a live
 * call is the one thing this column must never do.
 */

/** How many entries the number keys reach. Beyond this: arrows and pointer only. */
export const NUMBER_KEY_COUNT = 9;

/** Names the cause, not the symptom. */
export const CATALOG_CHANGED_COPY = "This campaign's outcomes changed. Pick one of these.";

/**
 * The entire mitigation for a callback surprise: a callback re-enters the
 * roster as an ordinary pending contact and **whichever agent is available takes
 * it**, so "I'll call you back" is a promise the product breaks. Sited next to the
 * time picker because that is the moment the agent decides what to say.
 */
export const CALLBACK_GROUND_TRUTH_COPY =
  'The callback goes back into the campaign queue. It may not be you who makes it.';

/** the pad's own labels are the only trustworthy guide after a re-sync. */
export const KEYS_REMAPPED_COPY = 'The number keys have moved. Read the labels for this one.';

/**
 * Whose clock the picker is on.
 *
 * the requirement asks for the callback to be captured *in the
 * contact's timezone*. **The console is not given one.** The API's
 * `AgencyReservedAttempt` carries no contact timezone and the bootstrap carries
 * no campaign default, so the chips and the picker are necessarily in the
 * agent's browser zone. Naming that is the honest half of "displayed
 * unambiguously" — an agent who does not know which clock they are reading will
 * promise a time they have silently converted.
 *
 * Delete this line the day the reserved frame carries the contact's zone; do not
 * delete it before.
 */
export const CALLBACK_TIMEZONE_COPY =
  'Times are shown in your timezone. We don’t have the customer’s on this screen — say the time out loud to agree it.';

export interface DispositionPadProps {
  /** `bootstrap.disposition_catalog`, or the `allowed_codes` rebuild. Never sorted. */
  catalog: AgencyDisposition[];
  form: DispositionFormState;
  onChange: (next: DispositionFormState) => void;
  /**
   * Frame-bound: rendered from `reserved` but disabled, enabled by
   * `bridged`, kept enabled through a `released` needing a disposition, disabled
   * again on `agent_state` leaving wrap-up after a successful submit.
   */
  enabled: boolean;
  /** Visible stated reason while disabled. A bare greyed pad reads as a permission error. */
  disabledReason?: string | null;
  /** Inline rejection copy, rendered **inside** the pad. Never a toast. */
  rejection?: string | null;
  /** True when an `allowed_codes` rebuild moved something a number key is bound to. */
  keysRemapped?: boolean;
  /** Corrected client-clock ms, for the callback-in-the-past check. */
  now: number;
  /** Called when the chosen code needs a note, so the page can focus the field. */
  onNeedsNote?: () => void;
  /** Lets the console's `C` shortcut select the callback code AND focus its row. */
  handleRef?: RefObject<DispositionPadHandle | null>;
}

export interface DispositionPadHandle {
  /**
   * The `C` shortcut: select the callback disposition and focus the time row.
   *
   * Both halves, in one call, deliberately. Selecting without moving focus is a
   * shortcut that half-works — worse than one that is absent, because the agent
   * learns to press it and then has to reach for the mouse anyway.
   *
   * Keyed on the `requires_datetime` **flag**, never on the string `'callback'`:
   * the built-in codes are conventions, every mechanism in the platform keys on
   * a flag, and a campaign may legally rename or replace them.
   */
  selectCallback: () => boolean;
}

export function DispositionPad({
  catalog,
  form,
  onChange,
  enabled,
  disabledReason = null,
  rejection = null,
  keysRemapped = false,
  now,
  onNeedsNote,
  handleRef,
}: DispositionPadProps) {
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const callbackRowRef = useRef<HTMLButtonElement | null>(null);
  const selectedIndex = catalog.findIndex((entry) => entry.code === form.selectedCode);
  const selected = findDisposition(catalog, form.selectedCode);

  optionRefs.current.length = catalog.length;

  useImperativeHandle(
    handleRef,
    () => ({
      selectCallback: () => {
        if (!enabled) return false;
        const entry = catalog.find((option) => option.requires_datetime);
        if (!entry) return false;
        onChange({ ...form, selectedCode: entry.code });
        // The row does not exist until the selection renders it, so focus is
        // deferred a frame rather than aimed at a node that is not there yet.
        window.setTimeout(() => callbackRowRef.current?.focus(), 0);
        return true;
      },
    }),
    [catalog, enabled, form, onChange],
  );

  // Past nine the pad scrolls, so the selected row is brought into view — an agent
  // arrowing to entry twelve must be able to see what they have chosen.
  useEffect(() => {
    if (selectedIndex < 0) return;
    optionRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const select = (code: string) => {
    if (!enabled) return;
    const entry = findDisposition(catalog, code);
    // Selecting a code never touches `notes`. The note survives every selection
    // change for the same reason it survives every error.
    onChange({ ...form, selectedCode: code });
    if (entry?.requires_note) onNeedsNote?.();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!enabled || catalog.length === 0) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    // Selection is immediate on arrow — there is no separate commit, so
    // there is no state where the highlight and the value disagree.
    const from = selectedIndex < 0 ? -1 : selectedIndex;
    const next =
      event.key === 'ArrowDown'
        ? (from + 1) % catalog.length
        : (from - 1 + catalog.length) % catalog.length;
    const entry = catalog[next];
    if (entry) {
      select(entry.code);
      optionRefs.current[next]?.focus();
    }
  };

  return (
    <div className={styles.pad} onKeyDown={onKeyDown}>
      <h2 className={styles.title}>Outcome</h2>

      {/* A disabled region always carries a visible stated reason (house rule). */}
      {!enabled && disabledReason ? (
        <p className={styles.disabledReason}>{disabledReason}</p>
      ) : null}

      {/*
        Inline, inside the pad, naming what happened — never a toast. An agent must
        not return to `available` believing a disposition saved when it did not.

        `allowed_codes` recovery is the parent's: it re-syncs the catalog and passes
        the new list plus this copy, so the pad below is already showing the codes
        the campaign will accept. **Never "contact support" while `allowed_codes` is
        present** — that copy is for errors with no recovery path, and using it here
        is what turned a one-click fix into an escalation.
      */}
      {rejection ? (
        <p className={styles.rejection} role="alert" data-testid="pad-rejection">
          {rejection}
        </p>
      ) : null}

      {keysRemapped ? (
        <p className={styles.remapWarning} data-testid="pad-keys-remapped">
          {KEYS_REMAPPED_COPY}
        </p>
      ) : null}

      <div className={styles.options} role="group" aria-label="Disposition">
        {catalog.map((entry, index) => {
          const isSelected = entry.code === form.selectedCode;
          return (
            <button
              key={entry.code}
              ref={(node) => {
                optionRefs.current[index] = node;
              }}
              type="button"
              className={styles.option}
              // Colour is never the only channel: the edge is paired with
              // the label, and `data-*` keeps the mapping assertable.
              data-success={entry.is_success ? 'true' : undefined}
              data-suppress={entry.suppress ? 'true' : undefined}
              data-selected={isSelected ? 'true' : undefined}
              aria-pressed={isSelected}
              /**
               * `aria-disabled`, not `disabled`. The pad is re-rendered whenever an
               * `agent_state` frame lands (one of four
               * places this bites), and a real `disabled` arriving under a focused
               * option blurs it in a browser — with re-enabling NOT restoring
               * focus. A keyboard agent would be dropped to `<body>` by a frame
               * that had nothing to do with them.
               */
              aria-disabled={!enabled || undefined}
              onClick={() => select(entry.code)}
            >
              {/*
                The number chip is rendered only where a key actually exists, so
                the pad never advertises a binding it does not have. `aria-hidden`
                because "1" read before every label is noise; the shortcut is
                discoverability for the eye.
              */}
              {index < NUMBER_KEY_COUNT ? (
                <span className={styles.key} aria-hidden="true">
                  {index + 1}
                </span>
              ) : (
                <span className={styles.keySpacer} aria-hidden="true" />
              )}
              <span className={styles.optionLabel}>{entry.label}</span>
            </button>
          );
        })}
      </div>

      {/*
        The callback row lives INSIDE the pad rather than in a modal: the
        overwhelming majority of callbacks are one of three times, and a dialog
        would cost two interactions for a chip press.
      */}
      {selected?.requires_datetime ? (
        <CallbackRow
          value={form.callbackAt}
          now={now}
          enabled={enabled}
          onPick={(value) => onChange({ ...form, callbackAt: value })}
          firstChipRef={callbackRowRef}
        />
      ) : null}
    </div>
  );
}

/** `YYYY-MM-DDTHH:mm` in the agent's own zone — the shape `datetime-local` takes. */
function datetimeLocalValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function atLocalTime(ms: number, dayOffset: number, hour: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/**
 * The resolved zone, rendered beside the choice.
 *
 * The chips are computed in the **agent's browser timezone**, which is not
 * necessarily the customer's — contact-timezone handling is Phase 3
 *. Naming the zone is cheap and it stops an agent promising a time
 * they have silently converted.
 */
function formatResolved(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });
}

function CallbackRow({
  value,
  now,
  enabled,
  onPick,
  firstChipRef,
}: {
  value: string | null;
  now: number;
  enabled: boolean;
  onPick: (value: string) => void;
  /** A plain mutable box: the pad writes the node into it for the C shortcut. */
  firstChipRef?: { current: HTMLButtonElement | null };
}) {
  const chips = [
    { label: 'In 1 hour', at: now + 60 * 60 * 1000 },
    { label: 'Tomorrow 10am', at: atLocalTime(now, 1, 10) },
    { label: 'Tomorrow 3pm', at: atLocalTime(now, 1, 15) },
  ];

  const parsed = value ? Date.parse(value) : NaN;

  return (
    <div className={styles.callback}>
      {/* Callback copy: "we", never "I" — and the question is asked in the plural too. */}
      <p className={styles.callbackTitle}>When should we call back?</p>
      <div className={styles.chips}>
        {chips.map((chip, index) => (
          <button
            key={chip.label}
            ref={
              index === 0 && firstChipRef
                ? (node) => {
                    firstChipRef.current = node;
                  }
                : undefined
            }
            type="button"
            className={styles.chip}
            aria-disabled={!enabled || undefined}
            data-selected={
              Number.isFinite(parsed) && datetimeLocalValue(chip.at) === value ? 'true' : undefined
            }
            onClick={() => {
              if (!enabled) return;
              onPick(datetimeLocalValue(chip.at));
            }}
          >
            {chip.label}
          </button>
        ))}
        <label className={styles.pick}>
          <span className={styles.pickLabel}>Pick…</span>
          <input
            type="datetime-local"
            className={styles.pickInput}
            value={value ?? ''}
            aria-label="Callback date and time"
            disabled={!enabled}
            onChange={(event) => onPick(event.target.value)}
          />
        </label>
      </div>

      {/* Rendered beside the choice rather than left implicit. */}
      {Number.isFinite(parsed) ? (
        <p className={styles.resolved} data-testid="callback-resolved">
          {formatResolved(parsed)}
        </p>
      ) : null}

      {/* Whose clock this is. The console is not told the customer's. */}
      <p className={styles.timezoneNote} data-testid="callback-timezone-note">
        {CALLBACK_TIMEZONE_COPY}
      </p>

      <p className={styles.groundTruth} data-testid="callback-ground-truth">
        {CALLBACK_GROUND_TRUTH_COPY}
      </p>
    </div>
  );
}
