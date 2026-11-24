import { useId } from 'react';
import { FieldError } from '../../../components/common/FieldError';
import {
  ABANDONMENT_GRACE_SECONDS,
  DEFAULT_ABANDONMENT_GRACE_MS,
  graceSecondsText,
} from '../../../utils/agency/abandonmentGrace';
import type { ConfigFieldErrors } from './configFieldErrors';
import styles from './CampaignBehaviourSection.module.css';

/*
  One of the editors `CampaignBehaviourSection` assembles, beside the abandonment limit: the
  abandonment grace (`abandonment_grace_ms`, decisions AG1–AG5), how long after the customer
  answers the agent's audio may connect before the call counts as abandoned. Whole seconds from 1
  to 5, 3 by default (`utils/agency/abandonmentGrace.ts`).

  The control sits inside the sentence it completes: "Count a call as abandoned if the agent's
  audio connects more than [3] seconds after the customer answers." The select is named by the
  two halves of that sentence (`aria-labelledby`), so a screen reader says the whole rule and then
  the value, and it is described by the hint. A native select: the keyboard, the phone's picker
  and the five values come with it, and nothing else can be chosen.
*/

const FIELD = 'abandonment_grace_ms';

interface AbandonmentGraceFieldProps {
  /** `abandonmentGraceMs`: the grace in ms, one of 1000–5000. */
  graceMs: number;
  onChange: (next: number) => void;
  errors: ConfigFieldErrors;
  /** A user who cannot write campaigns: the select is disabled; the value is still read out. */
  readOnly?: boolean;
}

export function AbandonmentGraceField({ graceMs, onChange, errors, readOnly = false }: AbandonmentGraceFieldProps) {
  const selectId = useId();
  const beforeId = useId();
  const afterId = useId();
  const hintId = useId();
  const errorId = useId();
  const message = errors.message(FIELD);
  const describedBy = [hintId, message ? errorId : null].filter(Boolean).join(' ');
  const seconds = graceMs / 1000;

  return (
    <div className="form-group" data-testid="abandonment-grace">
      <p className={styles.graceSentence}>
        <span id={beforeId}>Count a call as abandoned if the agent’s audio connects more than</span>{' '}
        <select
          id={selectId}
          className={styles.graceSelect}
          value={String(seconds)}
          disabled={readOnly}
          onChange={(event) => onChange(Number(event.target.value) * 1000)}
          aria-labelledby={`${beforeId} ${afterId}`}
          aria-describedby={describedBy}
          aria-invalid={message ? true : undefined}
          data-testid="abandonment-grace-select"
        >
          {/* A value outside the choices (not storable, but never shown as another) stays visible. */}
          {(ABANDONMENT_GRACE_SECONDS.includes(seconds) ? ABANDONMENT_GRACE_SECONDS : [...ABANDONMENT_GRACE_SECONDS, seconds]).map((s) => (
            <option key={s} value={String(s)}>{s}</option>
          ))}
        </select>{' '}
        <span id={afterId}>{seconds === 1 ? 'second' : 'seconds'} after the customer answers.</span>
      </p>
      <FieldError id={errorId} message={message} className="error-text" />
      <p className={styles.hint} id={hintId} data-testid="abandonment-grace-hint">
        {`The default is ${graceSecondsText(DEFAULT_ABANDONMENT_GRACE_MS)}. The carrier’s own audio set-up can take a second or more after the answer, so a shorter time counts more calls as abandoned. A change applies to calls made after you save; calls already made keep the time they were judged by.`}
      </p>
    </div>
  );
}
