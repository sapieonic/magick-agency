import { forwardRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  NOTES_FOREIGN_WRITE_COPY,
  NOTES_FOREIGN_WRITE_TONE,
  type NotesStatus,
} from '../../utils/agencyNotes';
import styles from './NotesField.module.css';

/**
 * The notes field and its status line (§A.13.7).
 *
 * All the truthfulness rules are in `agencyNotes` — the seven-state status line,
 * the tone rule, the keystroke-vs-save comparison — because every one of them fails
 * by *looking fine*. This component renders the answer and adds two behaviours of
 * its own.
 *
 * ── `Esc` blurs; it does not clear ───────────────────────────────────────────
 * Destroying an eight-minute call's notes with a stray `Esc` is unrecoverable, and
 * `Esc` means "get me out of here" everywhere else in this console. The field is
 * also **not** a keyboard trap: `Tab` moves out of it.
 *
 * ── The component cannot produce a provenance it has not earned ──────────────
 * It emits `onAgentEdit`, not `onChange(value, source)`. A keystroke, a paste and a
 * deletion are the only things that can fire it, so the caller cannot be handed
 * `'agent_edit'` for a value that came from a render, a reset or an attempt switch
 * — which is precisely the provenance that licenses a destructive empty save. The
 * guard in the API client checks provenance; this is what makes the claim true at
 * the source rather than merely asserted at the call site.
 */

export interface NotesFieldProps {
  value: string;
  /** Fired ONLY by a real agent edit. There is no other way to emit a value. */
  onAgentEdit: (value: string) => void;
  /** From `notesStatus()`. Never assembled here. */
  status: NotesStatus;
  /** Response echo differed from what was sent — an additional line, not a state. */
  foreignWrite?: boolean;
  /** Enabled during `on_call` and `wrapup` only. */
  enabled: boolean;
  /** Visible stated reason while disabled. */
  disabledReason?: string | null;
  /** `Ctrl`/`Cmd`+`Enter` — one of the two keys not suppressed inside a text input. */
  onSubmit?: () => void;
}

export const NotesField = forwardRef<HTMLTextAreaElement, NotesFieldProps>(function NotesField(
  { value, onAgentEdit, status, foreignWrite = false, enabled, disabledReason = null, onSubmit },
  ref,
) {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      // Blur, never clear.
      event.currentTarget.blur();
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onSubmit?.();
    }
    // Everything else — including every single-key shortcut — is left alone. The
    // page's global handler is what declines to act while focus is in here; a
    // `stopPropagation` on this element would also swallow `Esc`, which must reach
    // it.
  };

  return (
    <div className={styles.group}>
      <label className={styles.label} htmlFor="agency-notes">
        Notes
        <span className={styles.shortcut} aria-hidden="true">
          N
        </span>
      </label>

      <textarea
        id="agency-notes"
        ref={ref}
        className={styles.textarea}
        value={value}
        /**
         * A real `disabled` here is correct and is NOT the mechanism-(b) hazard.
         * §A.13.9's fixed tab order requires inactive controls to be `disabled` so
         * they are skipped rather than reordered, and this transition is driven by
         * `agent_state` leaving wrap-up — at which point the notes route stops
         * accepting writes anyway, so a focusable-but-inert textarea would invite
         * typing that can never be saved. The hazard is disabling a control *whose
         * own request is in flight*; that is the ✕ and the presence button, not
         * this.
         */
        disabled={!enabled}
        aria-describedby="agency-notes-status"
        onKeyDown={onKeyDown}
        onChange={(event) => onAgentEdit(event.target.value)}
      />

      {/*
        The status line. Tone AND weight, because colour alone is not a distinction
        (§A.11) — a colour-blind agent, or a badly-calibrated agency-floor monitor,
        must still see the difference between "Saved 14:32" and "Not saved to the
        server".

        `data-state` is exported so a test can assert the STATE rather than matching
        copy, which keeps the tone assertions independent of a wording change.
      */}
      <p
        id="agency-notes-status"
        className={styles.status}
        data-tone={status.tone}
        data-state={status.state}
        style={{ fontWeight: status.weight }}
      >
        {status.copy}
      </p>

      {/*
        An ADDITIONAL line rather than a replacement state, so it can coexist with
        any of the seven. A supervisor editing an attempt's notes while the agent
        types is a supported operation (`on_behalf`), not an anomaly — hence a real
        state rather than a defensive branch. Deliberately NOT in the resting copy:
        a permanent last-write-wins caveat is noise that trains the agent to ignore
        the line that matters on the day it is not noise.
      */}
      {foreignWrite ? (
        <p className={styles.status} data-tone={NOTES_FOREIGN_WRITE_TONE} data-state="foreign_write">
          {NOTES_FOREIGN_WRITE_COPY}
        </p>
      ) : null}

      {!enabled && disabledReason ? (
        <p className={styles.disabledReason}>{disabledReason}</p>
      ) : null}
    </div>
  );
});
