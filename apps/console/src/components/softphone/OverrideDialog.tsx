import { useEffect, useId, useState } from 'react';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import {
  OVERRIDE_NOTE_BLOCK_COPY,
  overrideNoteBlock,
} from '../../utils/softphone/overrides';
import { SOFTPHONE_OVERRIDE_NOTE_MAX } from '../../types/softphone';
import type { OverridePrompt } from '../../hooks/useSoftphone';
import styles from './SoftphoneView.module.css';

/**
 * "Call anyway" for a DNC hit (SP1) or a closed calling window (SP2).
 *
 * Says exactly what matched — the entry's scope, reason and date, or the window,
 * whose timezone it is read in and when it next opens — and what calling anyway
 * costs (it is logged with the agent's name and reason). The note is required,
 * 10–500 characters after trimming, with a live counter; "Call anyway" stays
 * disabled until it is long enough, and a refusal of the note comes back inline.
 *
 * Built on the shared `Modal`, so the focus trap, Escape and the focus return
 * are `useDialogFocus`'s; the note takes focus on open (`data-autofocus`), since
 * writing it is the only thing the agent can usefully do here. The overlay does
 * not dismiss it: a stray click must not throw away a half-written reason.
 */
export function OverrideDialog({
  prompt,
  submitting,
  error,
  onConfirm,
  onCancel,
}: {
  prompt: OverridePrompt | null;
  submitting: boolean;
  error: string | null;
  onConfirm: (note: string) => void;
  onCancel: () => void;
}) {
  const noteId = useId();
  const counterId = useId();
  const [note, setNote] = useState('');
  const kind = prompt?.kind ?? null;

  // A new prompt (the second refusal of one dial) starts a new note.
  useEffect(() => {
    setNote('');
  }, [kind, prompt?.refusal]);

  if (!prompt) return null;
  const { description } = prompt;
  const block = overrideNoteBlock(note);
  const trimmed = note.trim().length;
  const showBlock = note.length > 0 && block !== null;

  return (
    <Modal
      open
      onClose={onCancel}
      title={description.title}
      size="md"
      closeOnOverlayClick={false}
      footer={
        <div className={styles.dialogFooter}>
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={submitting}>
            Don’t call
          </button>
          <button
            type="button"
            className="btn-ember"
            onClick={() => onConfirm(note)}
            disabled={block !== null || submitting}
            data-testid="override-confirm"
          >
            {submitting ? 'Calling…' : description.confirmLabel}
          </button>
        </div>
      }
    >
      <div data-testid={`override-dialog-${prompt.kind}`}>
        <dl className={styles.overrideFacts}>
          {description.facts.map((fact) => (
            <div key={fact.label} style={{ display: 'contents' }}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
        <p className={styles.overrideConsequence}>{description.consequence}</p>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label htmlFor={noteId}>
            {description.noteLabel}
            <span className="required-star" aria-hidden="true">
              *
            </span>
          </label>
          <textarea
            id={noteId}
            data-autofocus="true"
            rows={4}
            value={note}
            maxLength={SOFTPHONE_OVERRIDE_NOTE_MAX + 50}
            aria-required="true"
            aria-invalid={showBlock || error ? true : undefined}
            aria-describedby={counterId}
            onChange={(event) => setNote(event.target.value)}
            data-testid="override-note"
          />
          <p id={counterId} className={styles.counter} data-state={block ? 'invalid' : 'ok'}>
            {showBlock ? `${OVERRIDE_NOTE_BLOCK_COPY[block!]} ` : ''}
            {trimmed} / {SOFTPHONE_OVERRIDE_NOTE_MAX}
          </p>
          {error ? (
            <p className="error-text" role="alert" data-testid="override-error">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
